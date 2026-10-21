import primaryLogo from "../assets/dispatch-logo-horizontal-primary.svg";
import inverseLogo from "../assets/dispatch-logo-horizontal-inverse.svg";
import iconMark from "../assets/dispatch-icon-mark-primary.svg";

export function Brand({ compact = false, inverse = false, decorative = false }: {
  compact?: boolean;
  inverse?: boolean;
  decorative?: boolean;
}) {
  return (
    <img
      className={compact ? "brand-mark" : "brand-logo"}
      src={compact ? iconMark : inverse ? inverseLogo : primaryLogo}
      alt={decorative ? "" : "Dispatch"}
      draggable={false}
    />
  );
}
