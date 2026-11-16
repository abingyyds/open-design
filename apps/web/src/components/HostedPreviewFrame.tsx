import { useEffect, useState, type ComponentPropsWithoutRef } from 'react';
import { isHostedPreviewEntry, newHostedPreviewNavigation } from '../runtime/hosted-preview-session';
import { useInView } from './plugins-home/useInView';

export function useHostedPreviewFrameSrc(src: string | undefined, hosted = true): string | undefined {
  const [bound, setBound] = useState<{ entry: string; url: string }>();
  const entry = hosted && src && isHostedPreviewEntry(src) ? src : undefined;
  useEffect(() => {
    setBound(entry ? { entry, url: newHostedPreviewNavigation(entry) } : undefined);
  }, [entry]);
  if (!entry) return src;
  return bound?.entry === entry ? bound.url : undefined;
}

export function HostedPreviewFrame({ src, hosted = true, loading, ...props }: ComponentPropsWithoutRef<'iframe'> & { hosted?: boolean }) {
  const defer = hosted && loading === 'lazy' && src !== undefined && isHostedPreviewEntry(src);
  const { ref, inView } = useInView<HTMLIFrameElement>({ enabled: defer, rootMargin: '0px' });
  const boundSrc = useHostedPreviewFrameSrc(defer && !inView ? undefined : src, hosted);
  // Once the parent assigns a fresh navigation, load it without another deferral.
  return <iframe {...props} ref={ref} loading={defer && inView ? 'eager' : loading} src={boundSrc} />;
}
