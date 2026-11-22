// Esc opens settings from any page, and on the settings page goes back. It does nothing while
// you are typing (a text box, a field, a list) or when another control has already used the key,
// so Esc never throws away what you are writing.
{
  const typing = (el) => el instanceof HTMLElement &&
    (el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName));
  const cog = document.querySelector(".settings-cog");
  const here = () => location.pathname + location.search;
  if (cog) cog.href = `/settings?from=${encodeURIComponent(here())}`;
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || typing(document.activeElement)) return;
    if (location.pathname === "/settings") {
      const back = document.querySelector("nav.course a");
      location.href = back ? back.getAttribute("href") : "/";
    } else {
      location.href = `/settings?from=${encodeURIComponent(here())}`;
    }
  });
}
