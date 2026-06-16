// Line-style icon set for the game shell — stroke uses currentColor so each
// icon inherits its button's text colour (gold when active). 24×24 grid.
import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement> & { className?: string };

function Svg({ className = "h-5 w-5", children, ...props }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
      {...props}
    >
      {children}
    </svg>
  );
}

export const IconMenu = (p: IconProps) => (
  <Svg {...p}>
    <line x1="4" y1="7" x2="20" y2="7" />
    <line x1="4" y1="12" x2="20" y2="12" />
    <line x1="4" y1="17" x2="20" y2="17" />
  </Svg>
);

export const IconChat = (p: IconProps) => (
  <Svg {...p}>
    <path d="M20 11.5a7.5 7.5 0 0 1-10.9 6.7L4 19l1-4.2A7.5 7.5 0 1 1 20 11.5Z" />
    <line x1="9" y1="11" x2="9" y2="11" />
    <line x1="12.5" y1="11" x2="12.5" y2="11" />
    <line x1="16" y1="11" x2="16" y2="11" />
  </Svg>
);

export const IconClose = (p: IconProps) => (
  <Svg {...p}>
    <line x1="6" y1="6" x2="18" y2="18" />
    <line x1="18" y1="6" x2="6" y2="18" />
  </Svg>
);

export const IconCue = (p: IconProps) => (
  <Svg {...p}>
    <line x1="20" y1="4" x2="8.5" y2="15.5" />
    <path d="M8.5 15.5 5 19l-1 1" />
    <circle cx="6.2" cy="17.8" r="2.2" />
  </Svg>
);

export const IconShop = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6 8h12l-1 11.5a1 1 0 0 1-1 .9H8a1 1 0 0 1-1-.9L6 8Z" />
    <path d="M9 8V6.5a3 3 0 0 1 6 0V8" />
  </Svg>
);

export const IconSpin = (p: IconProps) => (
  <Svg {...p}>
    <path d="M20 12a8 8 0 1 1-2.3-5.6" />
    <path d="M20 4v3.5h-3.5" />
  </Svg>
);

export const IconAim = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="7" />
    <line x1="12" y1="2.5" x2="12" y2="5" />
    <line x1="12" y1="19" x2="12" y2="21.5" />
    <line x1="2.5" y1="12" x2="5" y2="12" />
    <line x1="19" y1="12" x2="21.5" y2="12" />
    <circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none" />
  </Svg>
);

export const IconSoundOn = (p: IconProps) => (
  <Svg {...p}>
    <path d="M5 9.5h3l4-3.5v12l-4-3.5H5a1 1 0 0 1-1-1v-3a1 1 0 0 1 1-1Z" />
    <path d="M16 9a4 4 0 0 1 0 6" />
    <path d="M18.5 6.5a7 7 0 0 1 0 11" />
  </Svg>
);

export const IconSoundOff = (p: IconProps) => (
  <Svg {...p}>
    <path d="M5 9.5h3l4-3.5v12l-4-3.5H5a1 1 0 0 1-1-1v-3a1 1 0 0 1 1-1Z" />
    <line x1="16" y1="9.5" x2="21" y2="14.5" />
    <line x1="21" y1="9.5" x2="16" y2="14.5" />
  </Svg>
);

export const IconHome = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 11.5 12 5l8 6.5" />
    <path d="M6 10.5V19a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1v-8.5" />
  </Svg>
);

export const IconTrophy = (p: IconProps) => (
  <Svg {...p}>
    <path d="M7 4h10v4a5 5 0 0 1-10 0V4Z" />
    <path d="M7 6H4.5a2.5 2.5 0 0 0 2.5 2.5M17 6h2.5A2.5 2.5 0 0 1 17 8.5" />
    <line x1="12" y1="13" x2="12" y2="17" />
    <path d="M8.5 20h7M9.5 20l.5-3h4l.5 3" />
  </Svg>
);

export const IconGift = (p: IconProps) => (
  <Svg {...p}>
    <rect x="4" y="9.5" width="16" height="4" rx="1" />
    <path d="M5.5 13.5V20h13v-6.5M12 9.5V20" />
    <path d="M12 9.5S10.5 5 8 5a2 2 0 0 0 0 4.5ZM12 9.5S13.5 5 16 5a2 2 0 0 1 0 4.5Z" />
  </Svg>
);

export const IconWallet = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3.5" y="6" width="17" height="13" rx="2.5" />
    <path d="M3.5 9.5h17" />
    <circle cx="16.5" cy="13" r="1.2" fill="currentColor" stroke="none" />
  </Svg>
);
