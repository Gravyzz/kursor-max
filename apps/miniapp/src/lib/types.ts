export type Role = 'student' | 'staff' | 'dean';
export interface Person {
  id: string;
  role: Role;
  fullName: string;
  universityId: string;
  universityName: string;
  universityShortName: string;
  isDemo: boolean;
  instituteId: string | null;
  instituteName: string | null;
  groupName: string | null;
}

export interface Me {
  user: { id: number; firstName: string | null; lastName: string | null; photoUrl: string | null };
  person: Person | null;
  persons: Person[];
  startParam: string | null;
  demoEnabled: boolean;
  /** Роль в демо-песочнице; null — демо не открывали. */
  demo: { role: DemoRole } | null;
  handbook: HandbookRef | null;
}

export type DemoRole = 'student' | 'editor' | 'dean';

// ─── Справочник факультета ───

export type BlockType =
  | 'text' | 'steps' | 'checklist' | 'faq' | 'contact' | 'place' | 'deadline'
  | 'link' | 'file' | 'alert' | 'chat' | 'glossary';

export interface Audience {
  courses?: number[];
  dorm?: boolean;
  tags?: string[];
}

interface BlockBase {
  id: string;
  audience?: Audience;
}

export type Block =
  | (BlockBase & { type: 'text'; text: string })
  | (BlockBase & { type: 'steps'; title?: string; items: Array<{ id: string; text: string; hint?: string }> })
  | (BlockBase & { type: 'checklist'; title?: string; items: Array<{ id: string; text: string; dueOn?: string }> })
  | (BlockBase & { type: 'faq'; items: Array<{ id: string; question: string; answer: string }> })
  | (BlockBase & { type: 'contact'; name: string; role?: string; room?: string; hours?: string; phone?: string; email?: string; maxLink?: string })
  | (BlockBase & { type: 'place'; title: string; address?: string; howTo?: string; mapLink?: string })
  | (BlockBase & { type: 'deadline'; title: string; startsOn: string; endsOn?: string; remindDays?: number[] })
  | (BlockBase & { type: 'link'; title: string; url: string; note?: string })
  | (BlockBase & { type: 'file'; title: string; url: string; note?: string })
  | (BlockBase & { type: 'alert'; tone: 'info' | 'warn'; text: string; endsOn?: string })
  | (BlockBase & { type: 'chat'; title: string; url: string; note?: string })
  | (BlockBase & { type: 'glossary'; items: Array<{ id: string; term: string; meaning: string }> });

export interface HandbookRef {
  id: string;
  slug: string;
  title: string;
  emoji: string;
}

export interface HandbookSectionPage {
  id: string;
  slug: string;
  title: string;
  summary: string | null;
  snippet: string;
  inherited: boolean;
}

export interface HandbookSection {
  slug: string;
  title: string;
  emoji: string;
  position: number;
  pages: HandbookSectionPage[];
}

export interface HandbookDeadline {
  id: string;
  title: string;
  startsOn: string;
  endsOn: string | null;
  daysLeft: number;
  pageId: string;
  pageTitle: string;
}

export interface HandbookAnnouncement {
  id: string;
  title: string;
  body: string;
  pageId: string | null;
  createdAt?: string;
  /** Читатель отметил «прочитано» — объявление в архиве. */
  readAt?: string | null;
  /** Срок показа прошёл. */
  expired?: boolean;
}

export interface HandbookProfile {
  course: number | null;
  dorm: boolean | null;
  program: string | null;
  tags: string[];
  reminders: boolean;
  filled: boolean;
}

export interface HandbookHome {
  handbook: HandbookRef & { subtitle: string | null; dutyContact: string | null; link: string };
  profile: HandbookProfile;
  timezone: string;
  today: string;
  announcements: HandbookAnnouncement[];
  /** Сколько объявлений в архиве читателя: прочитанные и прошедшие. */
  archivedAnnouncements: number;
  deadlines: HandbookDeadline[];
  checklists: Array<{ pageId: string; title: string; total: number; completed: number }>;
  sections: HandbookSection[];
  popular: string[];
  myOpenQuestions: number;
  linked: boolean;
  editorRole: 'admin' | 'editor' | null;
}

export interface HandbookPageView {
  page: {
    id: string;
    slug: string;
    title: string;
    summary: string | null;
    section: { slug: string; title: string; emoji: string };
    blocks: Block[];
    updatedAt: string;
    checkedAt: string | null;
    inherited: boolean;
    helpful: number;
    notHelpful: number;
  };
  progress: string[];
  myFeedback: boolean | null;
  siblings: Array<{ id: string; title: string }>;
  link: string;
  today: string;
  /** Напоминания о сроках у читателя, если сервер их отдаёт вместе со страницей. */
  reminders?: boolean;
}

export interface HandbookHit {
  pageId: string;
  slug: string;
  title: string;
  snippet: string;
  section: string;
  score: number;
  exact: boolean;
}

export interface HandbookQuestion {
  id: string;
  text: string;
  status: 'open' | 'answered';
  answer: string | null;
  createdAt: string;
  answeredAt: string | null;
}

export interface HandbookListItem {
  id: string;
  slug: string;
  title: string;
  subtitle: string | null;
  emoji: string;
  university: string;
  institute: string | null;
  is_demo: boolean;
}

export interface HandbookMember {
  personId: string;
  fullName: string;
  role: 'admin' | 'editor';
  connected: boolean;
  you: boolean;
  link: string | null;
}
