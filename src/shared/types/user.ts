export interface UserProfile {
  id: string
  displayName: string
  email: string | null
  avatarUrl: string | null
  role: 'admin' | 'member'
  title: string | null
  jobFunction: string | null
  createdAt: string
}
