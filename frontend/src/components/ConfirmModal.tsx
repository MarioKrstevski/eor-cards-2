import { useEffect, useRef } from 'react';

interface ConfirmModalProps {
  title: string;
  message: string;
  confirmLabel?: string;
  variant?: 'danger' | 'primary';
  onConfirm: () => void;
  onCancel: () => void;
}

export default function ConfirmModal({
  title,
  message,
  confirmLabel = 'Delete',
  variant = 'danger',
  onConfirm,
  onCancel,
}: ConfirmModalProps) {
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    cancelRef.current?.focus();
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onCancel();
    }
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [onCancel]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      aria-modal="true"
      role="dialog"
    >
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/30 backdrop-blur-sm"
        onClick={onCancel}
      />

      {/* Dialog */}
      <div className="relative bg-white rounded-2xl shadow-lg w-full max-w-sm mx-4 p-6">
        <h2 className="text-base font-semibold text-gray-900 mb-1.5">{title}</h2>
        <p className="text-sm text-gray-500 leading-relaxed mb-6">{message}</p>
        <div className="flex justify-end gap-2.5">
          <button
            ref={cancelRef}
            onClick={onCancel}
            className="px-4 py-2 text-sm font-medium text-gray-600 hover:text-gray-800 border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors duration-150 focus:outline-none focus:ring-2 focus:ring-gray-200"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            className={`px-4 py-2 text-sm font-medium text-white rounded-lg transition-colors duration-150 focus:outline-none focus:ring-2 focus:ring-offset-1 ${variant === 'primary' ? 'bg-blue-700 hover:bg-blue-800 focus:ring-blue-400' : 'bg-red-500 hover:bg-red-600 focus:ring-red-400'}`}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
