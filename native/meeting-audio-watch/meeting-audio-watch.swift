// meeting-audio-watch — streams the set of apps currently capturing microphone
// input, so Cyggie can stop recording the instant the meeting app releases the
// mic (i.e. the call ended) — Granola-style, no extra permission beyond the
// audio access Cyggie already has.
//
// Uses the Core Audio process-object API (macOS 14.0+):
//   kAudioHardwarePropertyProcessObjectList → every process with an audio path
//   kAudioProcessPropertyPID                 → that process's pid
//   kAudioProcessPropertyIsRunningInput      → is it actively capturing input?
// Helper (e.g. Chrome renderer) pids are attributed to their host app by
// walking the parent chain until a pid resolves to a GUI app.
//
// Protocol: prints one JSON line to stdout whenever the set of mic-using host
// bundle ids CHANGES (and once at startup):
//   {"bundles":["com.google.Chrome","us.zoom.xos"]}
// The consumer (MeetingAudioWatcher in TS) owns all meeting-vs-not logic.
//
// Build:  swiftc -O meeting-audio-watch.swift -o meeting-audio-watch

import AppKit
import CoreAudio
import Foundation

setbuf(stdout, nil) // unbuffered: deliver each change line immediately

let systemObject = AudioObjectID(kAudioObjectSystemObject)
let pollInterval: TimeInterval = 0.75

func processObjectIDs() -> [AudioObjectID] {
    var address = AudioObjectPropertyAddress(
        mSelector: kAudioHardwarePropertyProcessObjectList,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
    var dataSize: UInt32 = 0
    guard AudioObjectGetPropertyDataSize(systemObject, &address, 0, nil, &dataSize) == noErr else {
        return []
    }
    let count = Int(dataSize) / MemoryLayout<AudioObjectID>.size
    var ids = [AudioObjectID](repeating: 0, count: count)
    guard AudioObjectGetPropertyData(systemObject, &address, 0, nil, &dataSize, &ids) == noErr else {
        return []
    }
    return ids
}

func isRunningInput(_ obj: AudioObjectID) -> Bool {
    var address = AudioObjectPropertyAddress(
        mSelector: kAudioProcessPropertyIsRunningInput,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
    var value: UInt32 = 0
    var size = UInt32(MemoryLayout<UInt32>.size)
    guard AudioObjectGetPropertyData(obj, &address, 0, nil, &size, &value) == noErr else {
        return false
    }
    return value != 0
}

func pidProperty(_ obj: AudioObjectID) -> pid_t {
    var address = AudioObjectPropertyAddress(
        mSelector: kAudioProcessPropertyPID,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
    var pid: pid_t = -1
    var size = UInt32(MemoryLayout<pid_t>.size)
    AudioObjectGetPropertyData(obj, &address, 0, nil, &size, &pid)
    return pid
}

func coreAudioBundleID(_ obj: AudioObjectID) -> String? {
    var address = AudioObjectPropertyAddress(
        mSelector: kAudioProcessPropertyBundleID,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
    var cfStr: Unmanaged<CFString>?
    var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
    guard AudioObjectGetPropertyData(obj, &address, 0, nil, &size, &cfStr) == noErr,
        let s = cfStr?.takeRetainedValue() as String?, !s.isEmpty
    else { return nil }
    return s
}

func parentPID(_ pid: pid_t) -> pid_t {
    var info = kinfo_proc()
    var size = MemoryLayout<kinfo_proc>.stride
    var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, pid]
    let r = mib.withUnsafeMutableBufferPointer { sysctl($0.baseAddress, 4, &info, &size, nil, 0) }
    return r == 0 ? info.kp_eproc.e_ppid : -1
}

// Resolve a (possibly helper) pid to its host app's bundle id.
func hostBundleID(pid: pid_t, obj: AudioObjectID) -> String? {
    var current = pid
    for _ in 0..<12 {
        if let app = NSRunningApplication(processIdentifier: current), let b = app.bundleIdentifier {
            return b
        }
        let parent = parentPID(current)
        if parent <= 1 || parent == current { break }
        current = parent
    }
    // Fall back to Core Audio's bundle id, stripping a helper suffix.
    if let ca = coreAudioBundleID(obj) {
        if let range = ca.range(of: ".helper") { return String(ca[..<range.lowerBound]) }
        return ca
    }
    return nil
}

func currentInputBundles() -> [String] {
    var set = Set<String>()
    for obj in processObjectIDs() where isRunningInput(obj) {
        if let bundle = hostBundleID(pid: pidProperty(obj), obj: obj) {
            set.insert(bundle)
        }
    }
    return set.sorted()
}

func emit(_ bundles: [String]) {
    // Minimal hand-rolled JSON (bundle ids are safe identifier strings).
    let quoted = bundles.map { "\"\($0)\"" }.joined(separator: ",")
    print("{\"bundles\":[\(quoted)]}")
}

var last: [String] = ["\u{0}"] // sentinel so the first real state always emits
while true {
    let now = currentInputBundles()
    if now != last {
        emit(now)
        last = now
    }
    Thread.sleep(forTimeInterval: pollInterval)
}
