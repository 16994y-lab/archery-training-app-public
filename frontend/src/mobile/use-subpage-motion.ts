import { useLayoutEffect, useRef, type RefObject } from 'react';
import { useLocation, useNavigationType } from 'react-router-dom';

type Scene = { page: string; key: string; depth: number };

const tabs = new Set(['training', 'score', 'history', 'news', 'profile']);
const recordPages = new Set(['detail', 'reflection', 'insights', 'group', 'report']);
const nestedPages = new Set(['plan', 'plan-detail', 'program', 'accessory', 'equipment', 'goal', 'target', 'group', 'report']);

function describeScene(route: string, search: string): Scene {
  const page = route === 'community' ? 'news' : route === 'compare' ? 'trends' : route;
  const params = new URLSearchParams(search);
  if (page === 'news') {
    const event = params.get('event');
    const article = params.get('story') || params.get('id');
    if (event) return { page, key: 'news:event:' + event, depth: 3 };
    if (article) return { page, key: 'news:article:' + article, depth: 2 };
    if (params.get('view') === 'more-events' && params.has('date')) return { page, key: 'news:day', depth: 2 };
    if (params.get('view') === 'more-events') return { page, key: 'news:month', depth: 1 };
    if (params.get('view') === 'calendar') {
      const view = params.get('entry') === 'individual' ? 'entries' : 'calendar';
      return { page, key: 'news:' + view, depth: 1 };
    }
  }
  const id = params.get('id');
  if (page === 'account' || page === 'rewards') {
    return { page, key: page + ':' + (id ?? ''), depth: id === 'cloud-conflicts' ? 3 : id ? 2 : 1 };
  }
  return {
    page,
    key: (recordPages.has(page) || nestedPages.has(page)) && id ? page + ':' + id : page,
    depth: tabs.has(page) ? 0 : nestedPages.has(page) ? 2 : 1,
  };
}

export function useSubpageMotion(ref: RefObject<HTMLElement | null>, route: string) {
  const location = useLocation();
  const navigation = useNavigationType();
  const previous = useRef<{ scene: Scene; index: number; locationKey: string } | null>(null);
  const { page, key, depth } = describeScene(route, location.search);

  useLayoutEffect(() => {
    const element = ref.current;
    const prior = previous.current;
    const index = window.history.state?.idx ?? 0;
    previous.current = { scene: { page, key, depth }, index, locationKey: location.key };
    if (!element || !prior || prior.scene.key === key || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    const sameLocation = prior.locationKey === location.key;
    const backward = sameLocation ? prior.scene.page === 'start'
      : navigation === 'POP' ? index <= prior.index
      : navigation === 'REPLACE' && depth < prior.scene.depth;
    const direction = depth === 0 && prior.scene.depth === 0 ? 'tab' : backward ? 'back' : 'forward';

    element.dataset.subpageMotion = direction;
    const timer = window.setTimeout(() => delete element.dataset.subpageMotion, 340);
    return () => {
      window.clearTimeout(timer);
      delete element.dataset.subpageMotion;
    };
  }, [ref, page, key, depth, location.key, navigation]);
}
