/* Движки веб-поиска и AI-чатов. Общий список для лаунчера и настроек. */

export interface Engine {
  id: string;
  name: string;
  ai?: boolean;         // открывает чат AI, а не поисковую выдачу
  prefixes: string[];   // алиасы для быстрого вызова: "g: ...", "c: ..."
  q: string;            // шаблон URL, {q} = запрос (уже url-энкодед)
}

export const ENGINES: Engine[] = [
  { id: "google", name: "Google", prefixes: ["g", "google"], q: "https://www.google.com/search?q={q}" },
  { id: "ddg", name: "DuckDuckGo", prefixes: ["ddg", "d"], q: "https://duckduckgo.com/?q={q}" },
  { id: "bing", name: "Bing", prefixes: ["b", "bing"], q: "https://www.bing.com/search?q={q}" },
  { id: "yandex", name: "Yandex", prefixes: ["ya", "yandex"], q: "https://yandex.ru/search/?text={q}" },
  { id: "claude", name: "Claude", ai: true, prefixes: ["c", "claude"], q: "https://claude.ai/new?q={q}" },
  { id: "chatgpt", name: "ChatGPT", ai: true, prefixes: ["gpt", "chatgpt"], q: "https://chatgpt.com/?q={q}" },
  { id: "perplexity", name: "Perplexity", ai: true, prefixes: ["p", "pplx"], q: "https://www.perplexity.ai/search?q={q}" },
];

export function engineById(id: string): Engine {
  return ENGINES.find(e => e.id === id) ?? ENGINES[0];
}

export function engineByPrefix(pfx: string): Engine | undefined {
  const p = pfx.toLowerCase();
  return ENGINES.find(e => e.prefixes.includes(p));
}

export function engineUrl(e: Engine, query: string): string {
  return e.q.replace("{q}", encodeURIComponent(query));
}
