import { rem } from "@mantine/core";

// Tiny rounded flag rendered from the `flag-icons` CSS sprite. We avoid bundling
// 26 SVGs by hand: the package ships one CSS file + flag backgrounds, and a span
// with class `fi fi-<code>` paints the right flag. Kept as a 4:3 chip.
export function Flag({ code, size = 20 }: { code: string; size?: number }) {
  return (
    <span
      className={`fi fi-${code}`}
      style={{
        width: rem(size),
        height: rem(size * 0.75),
        borderRadius: rem(3),
        backgroundSize: "cover",
        backgroundPosition: "center",
        display: "inline-block",
        boxShadow: "0 0 0 1px rgba(0,0,0,0.08)",
      }}
    />
  );
}
