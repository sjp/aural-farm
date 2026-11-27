import { useEffect, useState } from "preact/hooks";

function matches(query: string): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia(query).matches;
}

/** Whether a CSS media query matches, kept up to date. */
export function useMediaQuery(query: string): boolean {
  const [match, setMatch] = useState(() => matches(query));
  useEffect(() => {
    if (typeof window.matchMedia !== "function") {
      return undefined;
    }
    const list = window.matchMedia(query);
    const update = () => {
      setMatch(list.matches);
    };
    update();
    list.addEventListener("change", update);
    return () => {
      list.removeEventListener("change", update);
    };
  }, [query]);
  return match;
}
