// Defaults for everything kept in storage.local, shared by the background page,
// the popup and the settings page so the three can never disagree.
var YS = globalThis.YS || (globalThis.YS = {});

// the language rule, edited on the settings page
YS.LANG_DEFAULTS = { autoLang: true, autoMine: "ru", autoOther: "en", langs: ["ru", "en"], anyLang: true };

// the popup's own fields
YS.POPUP_DEFAULTS = { lang: "", timestamps: true, limit: 0 };
