import {
  Search, ArrowRight, ScanLine, UserRound, Sun, Moon, Contrast, ChevronRight, Bell,
  CircleHelp, X, Pencil, LibraryBig, BookOpen, ChartNoAxesColumnIncreasing, UsersRound,
  Megaphone, Target, MapPin, Clock3, Link, MessageCircle, FileText, TriangleAlert, Info,
  AlignLeft, List, SquareCheck, Check, LockKeyhole, ArrowUp, ArrowDown, GraduationCap,
  RefreshCw, Plus, House, ArrowLeft, ChevronDown, CalendarDays, Settings, Share2,
  LogOut, Trash2, Copy, Download, Dumbbell, Wallet, Star, LifeBuoy, ThumbsUp, ThumbsDown, ListChecks, EllipsisVertical, type LucideIcon,
} from 'lucide-react';

/** Единый набор Lucide, как в прототипе. Значки декоративные; подпись задаёт кнопка. */
const ICONS = {
  search: Search, arrow: ArrowRight, scan: ScanLine, user: UserRound, sun: Sun, moon: Moon,
  auto: Contrast, chevron: ChevronRight, bell: Bell, question: CircleHelp, close: X,
  edit: Pencil, books: LibraryBig, book: BookOpen, chart: ChartNoAxesColumnIncreasing,
  team: UsersRound, megaphone: Megaphone, target: Target, pin: MapPin, clock: Clock3,
  link: Link, chat: MessageCircle, file: FileText, warn: TriangleAlert, info: Info,
  text: AlignLeft, list: List, check: SquareCheck, done: Check, lock: LockKeyhole,
  up: ArrowUp, down: ArrowDown, cap: GraduationCap, reset: RefreshCw, plus: Plus,
  home: House, back: ArrowLeft, 'chevron-down': ChevronDown, calendar: CalendarDays,
  settings: Settings, share: Share2, logout: LogOut, trash: Trash2, copy: Copy, download: Download,
  sport: Dumbbell, wallet: Wallet, star: Star, help: LifeBuoy, like: ThumbsUp, dislike: ThumbsDown,
  checklist: ListChecks, more: EllipsisVertical,
} satisfies Record<string, LucideIcon>;
export type IconName = keyof typeof ICONS;

export function Icon({ name, size = 20 }: { name: IconName; size?: number }) {
  const Glyph = ICONS[name];
  return <Glyph className="pd-icon" size={size} strokeWidth={2} aria-hidden="true" focusable="false" />;
}

/**
 * Знак «Курсора»: указатель мыши и текстовая каретка — «навести и найти».
 * Свой рисунок, а не стандартная стрелка навигации: та читается как геолокация.
 */
export function BrandMark({ size = 28 }: { size?: number }) {
  return (
    <svg className="pd-icon pd-brandmark" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M3.4 3.2 L3.4 19 L7.4 15.2 L10.1 21 L13 19.7 L10.4 14 L15.6 13.8 Z" fill="currentColor" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
      <rect x="18.2" y="2.6" width="2.8" height="18.8" rx="1.4" fill="currentColor" opacity="0.7" />
    </svg>
  );
}
