import { tagColor } from '../utils/tags';

// Small colored pill for a role tag (mentor, lead, …). `xs` renders the
// compact variant used next to chat messages.
export default function TagPill({ tag, xs = false, onRemove, title }) {
  const c = tagColor(tag);
  return (
    <span
      title={title || tag}
      className={`inline-flex items-center gap-1 rounded ${xs ? 'text-xs px-1 py-0.5' : 'text-xs px-2 py-0.5'}`}
      style={{ background: c.bg, color: c.color, border: `1px solid ${c.border}`, lineHeight: 1.2 }}
    >
      {tag}
      {onRemove && (
        <button type="button" onClick={onRemove} title={`Remove tag "${tag}"`
                } className="rounded-full hover:opacity-70 leading-none"
                style={{ color: c.color }}>
          ×
        </button>
      )}
    </span>
  );
}
