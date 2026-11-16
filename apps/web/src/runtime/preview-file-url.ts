function encodeFilePath(filePath: string): string {
  return filePath.split('/').map(encodeURIComponent).join('/');
}

export function projectPreviewFileUrl(projectId: string, filePath: string): string {
  return `/api/projects/${encodeURIComponent(projectId)}/preview-files/${encodeFilePath(filePath)}`;
}

export function hostedPreviewPresentationUrl(projectId: string, filePath: string): string {
  return `/preview-presentation/?${new URLSearchParams({ project: projectId, file: filePath })}`;
}

export function designSystemPreviewFileUrl(designSystemId: string, filePath: string): string {
  return `/api/design-systems/${encodeURIComponent(designSystemId)}/preview-files/${encodeFilePath(filePath)}`;
}
