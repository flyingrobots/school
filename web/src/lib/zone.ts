// The learner's time zone (flyingrobots/school#178). The server runs in UTC under Docker, so every
// request whose answer names a day sends the browser's zone as `tz`.
export const learnerZone = () =>
  Intl.DateTimeFormat().resolvedOptions().timeZone

export const tzParam = () => `tz=${encodeURIComponent(learnerZone())}`
