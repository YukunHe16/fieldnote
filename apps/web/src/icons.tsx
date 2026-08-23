import type { SVGProps } from "react";

type IconName =
  | "activity"
  | "archive"
  | "arrowUp"
  | "brand"
  | "chat"
  | "check"
  | "chevronRight"
  | "close"
  | "copy"
  | "edit"
  | "clock"
  | "file"
  | "globe"
  | "learning"
  | "memory"
  | "menu"
  | "microphone"
  | "moon"
  | "more"
  | "paperclip"
  | "pin"
  | "plus"
  | "retry"
  | "replay"
  | "search"
  | "send"
  | "share"
  | "sidebar"
  | "status"
  | "stop"
  | "sun"
  | "thumbDown"
  | "thumbUp"
  | "trash"
  | "unarchive"
  | "warning"
  | "workspace"
  | "book"
  | "spark";

const paths: Record<IconName, React.ReactNode> = {
  activity: (
    <>
      <path d="M4.25 16.8 8.6 12.45l3.15 2.5 7-7" />
      <circle cx="4.25" cy="16.8" r="1.35" />
      <circle cx="11.75" cy="14.95" r="1.35" />
      <circle cx="18.75" cy="7.95" r="1.35" />
    </>
  ),
  archive: (
    <>
      <rect x="3.75" y="5.25" width="16.5" height="14.25" rx="2.25" />
      <path d="M3.25 8.75h17.5M9.25 12.75h5.5" />
    </>
  ),
  arrowUp: (
    <>
      <path d="M12 19.25V4.75M6.5 10.25 12 4.75l5.5 5.5" />
    </>
  ),
  brand: (
    <>
      <path d="M4.25 5.25c3.05-.95 5.65-.4 7.75 1.65v12c-2.1-2.05-4.7-2.6-7.75-1.65v-12Z" />
      <path d="M19.75 5.25c-3.05-.95-5.65-.4-7.75 1.65v12c2.1-2.05 4.7-2.6 7.75-1.65v-12Z" />
      <path d="M12 6.9v12" />
    </>
  ),
  chat: (
    <path d="M5.25 4.25h13.5a2.5 2.5 0 0 1 2.5 2.5v8.5a2.5 2.5 0 0 1-2.5 2.5H10l-4.75 3v-3.2a2.5 2.5 0 0 1-2-2.45V6.75a2.5 2.5 0 0 1 2-2.5Z" />
  ),
  check: <path d="m5.25 12.25 4.1 4.1 9.4-9.45" />,
  chevronRight: <path d="m9.25 18 6-6-6-6" />,
  close: <path d="m6.5 6.5 11 11m0-11-11 11" />,
  clock: (
    <>
      <circle cx="12" cy="12" r="8.75" />
      <path d="M12 7.25v5.25l3.4 2.1" />
    </>
  ),
  copy: (
    <>
      <rect x="8" y="8" width="11.5" height="11.5" rx="2.25" />
      <path d="M15.5 8V5.75a2.25 2.25 0 0 0-2.25-2.25h-7.5A2.25 2.25 0 0 0 3.5 5.75v7.5a2.25 2.25 0 0 0 2.25 2.25H8" />
    </>
  ),
  edit: (
    <>
      <path d="M4.25 19.75h4.1L19 9.1l-4.1-4.1L4.25 15.65v4.1Z" />
      <path d="m12.75 7.15 4.1 4.1" />
    </>
  ),
  file: (
    <>
      <path d="M6.25 2.75h7.5l4 4v14.5H6.25z" />
      <path d="M13.75 2.75v4.5h4M9 12h6M9 15.5h6" />
    </>
  ),
  globe: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3c2.35 2.45 3.55 5.45 3.55 9S14.35 18.55 12 21M12 3C9.65 5.45 8.45 8.45 8.45 12S9.65 18.55 12 21" />
    </>
  ),
  learning: (
    <>
      <path d="m3.5 9.25 8.5-4.5 8.5 4.5-8.5 4.5-8.5-4.5Z" />
      <path d="M6.5 11v5.25c3.25 2.35 7.75 2.35 11 0V11M20.5 9.25v6" />
    </>
  ),
  menu: <path d="M4.75 7.25h14.5m-14.5 4.75h14.5m-14.5 4.75h14.5" />,
  memory: (
    <>
      <path d="M6.25 3.5h9.5a2.5 2.5 0 0 1 2.5 2.5v14.5H7.5a2.75 2.75 0 0 1-2.75-2.75V5a1.5 1.5 0 0 1 1.5-1.5Z" />
      <path d="M4.75 17.75A2.75 2.75 0 0 1 7.5 15h10.75M9 7.25h5" />
    </>
  ),
  microphone: (
    <>
      <rect x="8.5" y="3.25" width="7" height="11.5" rx="3.5" />
      <path d="M5.75 11.75a6.25 6.25 0 0 0 12.5 0M12 18v3M8.75 21h6.5" />
    </>
  ),
  moon: <path d="M19.75 15.2A8.25 8.25 0 0 1 8.8 4.25a8.5 8.5 0 1 0 10.95 10.95Z" />,
  more: (
    <>
      <circle cx="5.25" cy="12" r="1.15" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.15" fill="currentColor" stroke="none" />
      <circle cx="18.75" cy="12" r="1.15" fill="currentColor" stroke="none" />
    </>
  ),
  paperclip: <path d="m8.15 12.15 6.45-6.4a3.55 3.55 0 0 1 5 5L10.1 20.2a5.05 5.05 0 0 1-7.15-7.15l9-9" />,
  pin: (
    <>
      <path d="m9.25 3.5 5.75 5.75-1.75 3.1 3.5 3.5-.9.9-3.5-3.5-3.1 1.75L3.5 9.25z" />
      <path d="m9.25 15-5 5" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  retry: (
    <>
      <path d="M19.75 7v5h-5" />
      <path d="M18.35 16.65A8.25 8.25 0 1 1 20 12" />
    </>
  ),
  replay: (
    <>
      <path d="M7.5 7.25 4.25 12 7.5 16.75" />
      <path d="M4.25 12h9.2a6 6 0 1 1 1.3 8.15" />
    </>
  ),
  search: (
    <>
      <circle cx="10.75" cy="10.75" r="6.75" />
      <path d="m15.75 15.75 4.5 4.5" />
    </>
  ),
  send: (
    <>
      <path d="m3.75 4.25 16.5 7.75-16.5 7.75 2.85-7.75-2.85-7.75Z" />
      <path d="M6.6 12h13.15" />
    </>
  ),
  share: (
    <>
      <path d="M12 15.5V3.75M7.5 8.25 12 3.75l4.5 4.5" />
      <path d="M6 11.5H4.75a1.5 1.5 0 0 0-1.5 1.5v6.25a1.5 1.5 0 0 0 1.5 1.5h14.5a1.5 1.5 0 0 0 1.5-1.5V13a1.5 1.5 0 0 0-1.5-1.5H18" />
    </>
  ),
  sidebar: (
    <>
      <rect x="3.25" y="4.25" width="17.5" height="15.5" rx="2.75" />
      <path d="M9 4.25v15.5" />
    </>
  ),
  status: (
    <>
      <circle cx="12" cy="12" r="8.75" />
      <path d="M8 12.25 10.75 15 16.5 9.25" />
    </>
  ),
  stop: <rect x="7.25" y="7.25" width="9.5" height="9.5" rx="1.75" fill="currentColor" stroke="none" />,
  sun: (
    <>
      <circle cx="12" cy="12" r="3.75" />
      <path d="M12 2.75v2M12 19.25v2M5.45 5.45l1.4 1.4m10.3 10.3 1.4 1.4M2.75 12h2m14.5 0h2M5.45 18.55l1.4-1.4m10.3-10.3 1.4-1.4" />
    </>
  ),
  thumbDown: (
    <>
      <path d="M7.5 4.25H4.25v10H7.5" />
      <path d="M7.5 13.75h2.25l2.5 5.1a1.7 1.7 0 0 0 3.2-.95v-3.65h2.35a2.25 2.25 0 0 0 2.2-2.7l-1-5a2.25 2.25 0 0 0-2.2-1.8H7.5z" />
    </>
  ),
  thumbUp: (
    <>
      <path d="M7.5 19.75H4.25v-10H7.5" />
      <path d="M7.5 10.25h2.25l2.5-5.1a1.7 1.7 0 0 1 3.2.95v3.65h2.35a2.25 2.25 0 0 1 2.2 2.7l-1 5a2.25 2.25 0 0 1-2.2 1.8H7.5z" />
    </>
  ),
  trash: (
    <>
      <path d="M4.25 7.25h15.5M9 7.25V4.5h6v2.75M6.75 7.25l1 13h8.5l1-13" />
      <path d="M10 11v5.5m4-5.5v5.5" />
    </>
  ),
  unarchive: (
    <>
      <rect x="3.75" y="5.25" width="16.5" height="14.25" rx="2.25" />
      <path d="M3.25 8.75h17.5M12 16.75v-5.5m-2.75 2.5L12 11l2.75 2.75" />
    </>
  ),
  warning: (
    <>
      <path d="M10.25 4.2 2.8 18a2 2 0 0 0 1.75 3h14.9a2 2 0 0 0 1.75-3L13.75 4.2a2 2 0 0 0-3.5 0Z" />
      <path d="M12 9v4.25M12 17.25h.01" />
    </>
  ),
  workspace: (
    <>
      <rect x="3.5" y="3.5" width="7.25" height="7.25" rx="1.85" />
      <rect x="13.25" y="3.5" width="7.25" height="7.25" rx="1.85" />
      <rect x="3.5" y="13.25" width="7.25" height="7.25" rx="1.85" />
      <rect x="13.25" y="13.25" width="7.25" height="7.25" rx="1.85" />
    </>
  ),
  book: (
    <>
      <path d="M5 4.25h11.25A2.5 2.5 0 0 1 18.75 6.75v12.5H7.25A2.25 2.25 0 0 1 5 17V4.25Z" />
      <path d="M5 17a2.25 2.25 0 0 1 2.25-2.25H18.75M8.75 8.25h6.5M8.75 11.5h4.5" />
    </>
  ),
  spark: <path d="M12 3.25 13.4 9.1 19.5 10.5 13.4 11.9 12 17.75 10.6 11.9 4.5 10.5 10.6 9.1Z" />
};

export function Icon({ name, size = 20, ...props }: { name: IconName; size?: number } & SVGProps<SVGSVGElement>) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.65"
      strokeLinecap="round"
      strokeLinejoin="round"
      vectorEffect="non-scaling-stroke"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      {paths[name]}
    </svg>
  );
}
