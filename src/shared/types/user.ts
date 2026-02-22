export interface UserProfile {
  id: string
  displayName: string
  email: string | null
  avatarUrl: string | null
  role: 'admin' | 'member'
  createdAt: string
}
