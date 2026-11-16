'use client';

import { useEffect, useState } from 'react';
import { HOSTED_PREVIEW_SANDBOX } from '@open-design/contracts';
import { HostedPreviewFrame } from '../../src/components/HostedPreviewFrame';
import { keepFramedPreviewsAlive } from '../../src/runtime/hosted-preview-session';
import { projectPreviewFileUrl } from '../../src/runtime/preview-file-url';

export default function HostedPreviewPresentation() {
  const [src, setSrc] = useState('');
  useEffect(() => {
    const query = new URLSearchParams(window.location.search);
    const project = query.get('project');
    const file = query.get('file');
    if (!project || !file || !/^[a-zA-Z0-9._-]{1,128}$/u.test(project) || /^\.+$/u.test(project)
      || file.split('/').some((part) => !part || part === '.' || part === '..' || part.includes('\\'))) return;
    const stop = keepFramedPreviewsAlive();
    setSrc(projectPreviewFileUrl(project, file));
    return stop;
  }, []);
  return src ? (
    <HostedPreviewFrame
      title="Presentation"
      src={src}
      sandbox={HOSTED_PREVIEW_SANDBOX}
      referrerPolicy="no-referrer"
      style={{ position: 'fixed', inset: 0, width: '100%', height: '100%', border: 0 }}
    />
  ) : null;
}
