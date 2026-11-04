export function processTime(value?: number) {
  if (value === undefined) return "Time unavailable";
  const date = new Date(value);
  const now = new Date();
  const time = date.toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  });
  return date.toDateString() === now.toDateString()
    ? time
    : `${date.toLocaleDateString([], { month: "short", day: "numeric", ...(date.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}) })}, ${time}`;
}
