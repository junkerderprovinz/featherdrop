import { rem } from "@mantine/core";

// A 4:3 flag from the flag-icons stylesheet, painted by the `fi fi-<code>`
// classes.
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
