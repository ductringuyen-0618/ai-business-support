/**
 * Visual star-rating renderer. Stars 1..N filled, rest outlined. Accessible
 * via an aria-label so screen readers don't get a soup of glyphs.
 */
export function StarRating({ value }: { value: number }) {
  const clamped = Math.max(0, Math.min(5, Math.round(value)));
  return (
    <span
      className="inline-flex items-center text-amber-500"
      aria-label={`${clamped} out of 5 stars`}
      title={`${clamped} out of 5 stars`}
    >
      {[1, 2, 3, 4, 5].map((n) => (
        <span key={n} aria-hidden="true" className="leading-none">
          {n <= clamped ? "★" : "☆"}
        </span>
      ))}
    </span>
  );
}
