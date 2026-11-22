// The chart example reads the website's design-system URL state to pick rounded corners.
// This app is the radix-nova style, so the answer is fixed.
export function useDesignSystemSearchParams() {
  return [{ style: "nova" }] as const
}
