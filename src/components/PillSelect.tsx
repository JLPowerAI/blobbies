import { ChevronDown } from "lucide-react";
import type { ReactNode } from "react";

/** Native select styled as a pill, used in Settings rows and the chat header. */
export function PillSelect({
  id,
  label,
  value,
  onChange,
  children,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  children: ReactNode;
}) {
  return (
    <span className="pill-select">
      <select
        id={id}
        aria-label={label}
        value={value}
        onChange={(event) => {
          // Native selects keep focus after the popup closes, leaving the
          // focus ring glowing until something else is clicked. Drop focus
          // once a choice is made; keyboard users re-Tab to continue.
          event.currentTarget.blur();
          onChange(event.currentTarget.value);
        }}
      >
        {children}
      </select>
      <ChevronDown size={14} strokeWidth={2} aria-hidden="true" className="pill-select-chevron" />
    </span>
  );
}
