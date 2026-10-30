// "/cemetery" — the quiet garden: residents who retired or left town. Newest first, 50 per page, live updates.
import { api, openStream } from "./api.js";
import { homeIndex } from "./market.js";
import { spriteIcon } from "./sprites.js";
import { reportButton } from "./report.js";
import { t, kindLabel } from "./i18n.js";
import { el, hash32 } from "./util.js";

const PAGE = 50;
const SHAPES = ["round", "arch", "obelisk", "flat", "cross"];
const localDate = (ts) => (ts ? new Date(ts).toLocaleDateString(document.documentElement.lang || undefined) : "?");

function lifespan(born, died) {
  if (!born || !died || died < born) return "";
  const h = (died - born) / 3600_000;
  if (h < 1) return t("cem.livedMin");
  if (h < 48) return t("cem.livedHours", { n: Math.round(h) });
  return t("cem.lived", { n: Math.round(h / 24) });
}

export function mountCemetery(root, { navigate, setHeaderStats }) {
  document.title = t("cem.docTitle");
  setHeaderStats([], "live");
  const count = el("p", { class: "cem-count muted" });
  const grid = el("div", { class: "cem-grid", "aria-live": "polite" });
  const more = el("button", { class: "btn", type: "button", hidden: true, onclick: () => load() }, t("cem.loadMore"));
  const status = el("p", { class: "muted", text: t("cem.loading") });
  const page = el("div", { class: "cem-page" },
    el("a", { href: "/", class: "back", onclick: (e) => { e.preventDefault(); navigate("/"); } }, t("home.backToTown")),
    el("header", { class: "cem-head" },
      el("h1", { text: t("cem.title") }),
      el("p", { class: "muted", text: t("cem.intro") }),
      count),
    status, grid, el("div", { class: "cem-more" }, more));
  root.append(page);

  let offset = 0, total = 0, dead = false, homes = new Map();
  const seen = new Set();

  function card(g) {
    const hidden = !!g.hidden;
    const shape = SHAPES[hash32(g.id ?? g.name ?? "") % SHAPES.length];
    const homeExists = g.home_id && homes.has(g.home_id);
    const homeName = hidden ? t("cem.hidden") : g.home_name;
    const [pre, post = ""] = t("cem.from").split("{home}"); // keeps word order per language
    const from = homeName
      ? el("p", { class: "cem-from small" }, pre,
          homeExists && !hidden
            ? el("a", { href: `/h/${g.home_id}`, onclick: (e) => { e.preventDefault(); navigate(`/h/${g.home_id}`); } }, homeName)
            : el("span", { text: homeName }), post)
      : null;
    const life = lifespan(g.born_at, g.died_at);
    return el("article", { class: `cem-card stone-${shape}${hidden ? " is-hidden" : ""}`, "data-id": g.id },
      el("div", { class: "stone" },
        el("div", { class: "cem-portrait" }, hidden ? el("span", { class: "cem-blank", text: "✿" }) : spriteIcon({ id: g.persona_id ?? g.id, kind: g.kind, sprite: g.sprite }, 1.5)),
        el("h2", { class: "cem-name", text: hidden ? t("cem.hidden") : g.name ?? t("home.anAgent") }),
        el("p", { class: "cem-kind small muted", text: kindLabel(g.kind ?? "other") }),
        from,
        el("p", { class: "cem-dates small muted" }, el("time", { text: localDate(g.born_at) }), " – ", el("time", { text: localDate(g.died_at) })),
        life ? el("p", { class: "cem-life small", text: life }) : null,
        !hidden && g.epitaph ? el("p", { class: "cem-epitaph", text: `“${g.epitaph}”` }) : null),
      hidden || !/^t_/.test(g.id ?? "") ? null : el("div", { class: "cem-actions" }, reportButton("tombstone", g.id)));
  }

  function renderCount() { count.textContent = total ? t("cem.count", { n: total }) : ""; }

  async function load() {
    more.disabled = true;
    try {
      if (!homes.size) homes = await homeIndex().catch(() => new Map());
      const r = await api(`/cemetery?limit=${PAGE}&offset=${offset}`);
      if (dead) return;
      total = r.total ?? total;
      const fresh = r.tombstones.filter((g) => !seen.has(g.id));
      for (const g of fresh) seen.add(g.id);
      grid.append(...fresh.map(card));
      offset += r.tombstones.length;
      status.hidden = true;
      if (!total) { status.textContent = t("cem.empty"); status.hidden = false; }
      more.hidden = offset >= total || !r.tombstones.length;
      renderCount();
    } catch {
      status.textContent = t("cem.loadError");
      status.hidden = false;
    } finally { more.disabled = false; }
  }

  const closeStream = openStream("", {
    tombstone: (g) => {
      if (seen.has(g.id)) return;
      seen.add(g.id);
      total++; offset++;
      status.hidden = true;
      grid.prepend(card(g));
      renderCount();
    },
    tombstone_update: (g) => {
      const old = grid.querySelector(`[data-id="${CSS.escape(g.id)}"]`);
      if (old) old.replaceWith(card(g));
    },
  });

  load();
  return () => { dead = true; closeStream(); page.remove(); };
}
