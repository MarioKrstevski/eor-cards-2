import { useCallback, useEffect, useState } from 'react';
import { getSection, verifySection } from '../api';
import type { SectionDetail, SectionImage } from '../types';

interface SectionViewerProps {
  sectionId: number;
  onClose: () => void;
}

export default function SectionViewer({ sectionId, onClose }: SectionViewerProps) {
  const [section, setSection] = useState<SectionDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [verifying, setVerifying] = useState(false);
  const [verifyResult, setVerifyResult] = useState<{ is_valid: boolean; flags: string[] } | null>(null);
  const [selectedImage, setSelectedImage] = useState<SectionImage | null>(null);
  const [showImages, setShowImages] = useState(false);

  const loadSection = useCallback(async () => {
    setLoading(true);
    try {
      const data = await getSection(sectionId);
      setSection(data);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, [sectionId]);

  useEffect(() => {
    loadSection();
  }, [loadSection]);

  const handleVerify = useCallback(async () => {
    setVerifying(true);
    try {
      const result = await verifySection(sectionId);
      setVerifyResult(result);
      loadSection();
    } catch {
      // ignore
    } finally {
      setVerifying(false);
    }
  }, [sectionId, loadSection]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-white rounded-2xl shadow-2xl w-[90vw] max-w-5xl h-[85vh] flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-center gap-3 px-6 py-4 border-b border-gray-200 shrink-0">
          <h2 className="text-sm font-bold text-gray-900 flex-1 truncate">
            {section?.heading ?? 'Loading...'}
          </h2>

          {section && (section.images?.length ?? 0) > 0 && (
            <button
              onClick={() => setShowImages(v => !v)}
              className={`flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium rounded-lg transition-colors duration-150 ${
                showImages
                  ? 'bg-blue-100 text-blue-700'
                  : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
              }`}
            >
              <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
              </svg>
              {section.images!.length} image{section.images!.length !== 1 ? 's' : ''}
            </button>
          )}

          {section && !section.is_verified && (
            <button
              onClick={handleVerify}
              disabled={verifying}
              className="px-3 py-1.5 text-xs font-medium text-white bg-green-600 rounded-lg hover:bg-green-700 disabled:opacity-50 transition-colors duration-150"
            >
              {verifying ? 'Verifying...' : 'Verify Section'}
            </button>
          )}

          {section?.is_verified && (
            <span className="flex items-center gap-1 text-xs font-medium text-green-600">
              <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
              </svg>
              Verified
            </span>
          )}

          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors duration-150"
          >
            <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {loading ? (
          <div className="flex-1 flex items-center justify-center">
            <span className="text-sm text-gray-400">Loading section content...</span>
          </div>
        ) : section ? (
          <div className="flex flex-1 overflow-hidden">
            {/* Main content */}
            <div className="flex-1 overflow-y-auto p-6">
              {/* Flags */}
              {(section.flags?.length ?? 0) > 0 && (
                <div className="mb-4 flex flex-wrap gap-1.5">
                  {section.flags!.map((flag, i) => (
                    <span key={i} className="inline-flex items-center px-2 py-0.5 rounded text-[11px] font-medium bg-amber-50 text-amber-700 border border-amber-200">
                      {flag}
                    </span>
                  ))}
                </div>
              )}

              {/* Verify result */}
              {verifyResult && (
                <div className={`mb-4 p-3 rounded-lg text-xs ${verifyResult.is_valid ? 'bg-green-50 text-green-700' : 'bg-amber-50 text-amber-700'}`}>
                  {verifyResult.is_valid ? 'Section verified successfully.' : `Issues found: ${(verifyResult.flags ?? []).join(', ')}`}
                </div>
              )}

              {/* Metadata */}
              <div className="mb-4 flex items-center gap-3 text-xs text-gray-500">
                {section.curriculum_topic_path && (
                  <span className="flex items-center gap-1">
                    <svg xmlns="http://www.w3.org/2000/svg" className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A1.994 1.994 0 013 12V7a4 4 0 014-4z" />
                    </svg>
                    {section.curriculum_topic_path}
                  </span>
                )}
                <span>{section.image_count} images</span>
                <span>{section.table_count} tables</span>
                <span>{section.card_count} cards</span>
              </div>

              {/* Content HTML */}
              <div
                className="section-content prose prose-sm max-w-none"
                dangerouslySetInnerHTML={{ __html: section.content_html }}
              />

              {/* Content blocks listing */}
              {section.content_blocks && section.content_blocks.length > 0 && (
                <div className="mt-6 border-t border-gray-200 pt-4">
                  <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">Content Blocks ({section.content_blocks.length})</h3>
                  <div className="space-y-2">
                    {section.content_blocks.map((block) => (
                      <div
                        key={block.id}
                        className={`p-3 rounded-lg border text-xs ${
                          block.is_duplicate
                            ? 'border-red-200 bg-red-50/50'
                            : 'border-gray-200 bg-white'
                        }`}
                      >
                        <div className="flex items-center gap-2 mb-1">
                          <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-gray-100 text-gray-600">{block.block_type}</span>
                          {block.heading_context && <span className="text-gray-400 truncate">{block.heading_context}</span>}
                          {block.is_duplicate && <span className="text-red-500 font-medium">DUPLICATE</span>}
                        </div>
                        <p className="text-gray-700 whitespace-pre-wrap">{block.text}</p>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Contributing uploads */}
              {section.uploads && section.uploads.length > 0 && (
                <div className="mt-6 border-t border-gray-200 pt-4">
                  <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">Source Uploads</h3>
                  <div className="space-y-1">
                    {section.uploads.map((upload) => (
                      <div key={upload.id} className="flex items-center gap-2 text-xs text-gray-600">
                        <svg xmlns="http://www.w3.org/2000/svg" className="h-3 w-3 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                        </svg>
                        <span>{upload.original_name}</span>
                        <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${
                          upload.status === 'ready' ? 'bg-green-50 text-green-600'
                          : upload.status === 'merged' ? 'bg-blue-50 text-blue-600'
                          : upload.status === 'error' ? 'bg-red-50 text-red-600'
                          : 'bg-gray-50 text-gray-500'
                        }`}>
                          {upload.status}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* Image sidebar — toggled */}
            {showImages && section.images && section.images.length > 0 && (
              <div className="w-64 border-l border-gray-200 overflow-y-auto p-3 shrink-0 bg-gray-50">
                <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">Images ({section.images.length})</h3>
                <div className="space-y-2">
                  {section.images.map((img, idx) => (
                    <div
                      key={img.id}
                      onClick={() => setSelectedImage(img)}
                      className="cursor-pointer rounded-lg border border-gray-200 overflow-hidden bg-white hover:shadow-md transition-shadow duration-150"
                    >
                      <img src={img.data_uri} alt={img.alt_text_hint ?? ''} className="w-full object-contain max-h-32" />
                      <div className="px-2 py-1.5">
                        <div className="flex items-center gap-1.5 mb-1">
                          <span className="text-[11px] font-semibold text-gray-700">Image {idx + 1}</span>
                          <span className={`text-[10px] font-medium px-1 py-0.5 rounded ${
                            img.category === 'diagram' ? 'bg-blue-50 text-blue-600'
                            : img.category === 'chart' ? 'bg-green-50 text-green-600'
                            : img.category === 'table_image' ? 'bg-purple-50 text-purple-600'
                            : img.category === 'decorative' ? 'bg-gray-100 text-gray-500'
                            : 'bg-amber-50 text-amber-600'
                          }`}>
                            {img.category}
                          </span>
                        </div>
                        {img.alt_text_hint && (
                          <p className="text-[10px] text-gray-500 line-clamp-1">{img.alt_text_hint}</p>
                        )}
                        {img.extracted_text && (
                          <p className="text-[10px] text-gray-500 mt-0.5 line-clamp-2">{img.extracted_text}</p>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className="flex-1 flex items-center justify-center">
            <span className="text-sm text-gray-400">Section not found</span>
          </div>
        )}
      </div>

      {/* Full-size image modal */}
      {selectedImage && (
        <div className="fixed inset-0 z-60 flex items-center justify-center bg-black/60" onClick={() => setSelectedImage(null)}>
          <div className="max-w-4xl max-h-[90vh] bg-white rounded-xl shadow-2xl p-4 overflow-auto" onClick={(e) => e.stopPropagation()}>
            <img src={selectedImage.data_uri} alt={selectedImage.alt_text_hint ?? ''} className="max-w-full" />
            {selectedImage.extracted_text && (
              <p className="mt-3 text-xs text-gray-600">{selectedImage.extracted_text}</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
