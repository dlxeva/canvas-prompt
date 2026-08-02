const PDF_MIME = 'application/pdf'
const PPTX_MIME = 'application/vnd.openxmlformats-officedocument.presentationml.presentation'

export function isArtifactReviewFile(file: Pick<File, 'name' | 'type'>) {
  const lowerName = file.name.toLowerCase()
  return file.type === PDF_MIME
    || file.type === PPTX_MIME
    || lowerName.endsWith('.pdf')
    || lowerName.endsWith('.pptx')
}
