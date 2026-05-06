import { useEffect, useRef } from 'react';

interface AlertModalProps {
  title: string;
  message: string;
  onClose: () => void;
}

export default function AlertModal({ title, message, onClose }: AlertModalProps) {
  const okRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    okRef.current?.focus();
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape' || e.key === 'Enter') onClose();
    }
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      aria-modal="true"
      role="alertdialog"
    >
      <div
        className="absolute inset-0 bg-black/30 backdrop-blur-sm"
        onClick={onClose}
      />
      <div className="relative bg-white rounded-2xl shadow-lg w-full max-w-sm mx-4 p-6">
        <h2 className="text-base font-semibold text-gray-900 mb-1.5">{title}</h2>
        <p className="text-sm text-gray-500 leading-relaxed mb-6">{message}</p>
        <div className="flex justify-end">
          <button
            ref={okRef}
            onClick={onClose}
            className="px-4 py-2 text-sm font-medium text-white bg-gray-800 hover:bg-gray-900 rounded-lg transition-colors duration-150 focus:outline-none focus:ring-2 focus:ring-gray-400 focus:ring-offset-1"
          >
            OK
          </button>
        </div>
      </div>
    </div>
  );
}
