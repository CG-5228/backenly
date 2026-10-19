import {
  Activity,
  Bot,
  Cable,
  Code2,
  Database,
  GitBranch,
  HardDrive,
  Radio,
  Rocket,
  Settings,
  Shield,
  Webhook,
  Zap,
  type LucideIcon,
} from 'lucide-react'
import type { DocSlug } from '@/app/docs/content'

/**
 * The console sidebar's own icons (components/shell/ProjectSidebar.tsx), so a
 * docs page and the screen it explains carry the same mark. If the console
 * changes an icon, change it here too.
 */
export const DOC_ICONS: Record<DocSlug, LucideIcon> = {
  database: Database,
  auth: Shield,
  storage: HardDrive,
  functions: Code2,
  realtime: Radio,
  integrations: Zap,
  autonomy: Bot,
  monitoring: Activity,
  branches: GitBranch,
  deploy: Rocket,
  connect: Cable,
  webhooks: Webhook,
  settings: Settings,
}
