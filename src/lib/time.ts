/** iMessage-style sidebar timestamp: "Now", "14:32", "Yesterday", "Mon", "12/3/25". */
export function formatAgentTime(lastActivityAt: number, now: number = Date.now()): string {
  if (now - lastActivityAt < 60_000) {
    return "Now";
  }
  const then = new Date(lastActivityAt);
  const today = new Date(now);
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const dayDiff = Math.round((startOfDay(today) - startOfDay(then)) / 86_400_000);
  if (dayDiff === 0) {
    return then.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  }
  if (dayDiff === 1) {
    return "Yesterday";
  }
  if (dayDiff < 7) {
    return then.toLocaleDateString(undefined, { weekday: "short" });
  }
  return then.toLocaleDateString(undefined, {
    day: "numeric",
    month: "numeric",
    year: "2-digit",
  });
}
