// Applies the saved dark theme before first paint to avoid a flash of light.
// Loaded synchronously in <head>, before the stylesheet. Light is the default;
// dark is applied only if the resident chose it (persisted in localStorage).
(function () {
  try {
    if (localStorage.getItem("pohTheme") === "dark") {
      document.documentElement.setAttribute("data-mode", "dark");
    }
  } catch (e) {}
})();
