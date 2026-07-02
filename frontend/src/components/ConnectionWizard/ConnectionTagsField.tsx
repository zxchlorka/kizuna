import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

interface ConnectionTagsFieldProps {
  value: string
  onChange: (value: string) => void
}

const suggestedTags = ['dev', 'staging', 'production']

function toggleTag(current: string, tag: string) {
  const tags = current
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)

  if (tags.includes(tag)) {
    return tags.filter((item) => item !== tag).join(', ')
  }

  return [...tags, tag].join(', ')
}

export function ConnectionTagsField({ value, onChange }: ConnectionTagsFieldProps) {
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        {suggestedTags.map((tag) => {
          const active = value
            .split(',')
            .map((item) => item.trim())
            .includes(tag)

          return (
            <Button
              key={tag}
              type="button"
              variant={active ? 'secondary' : 'outline'}
              size="sm"
              className="h-8 px-3 font-mono text-[11px] uppercase tracking-[0.12em]"
              onClick={() => onChange(toggleTag(value, tag))}
            >
              {tag}
            </Button>
          )
        })}
      </div>
      <Input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder="production, reporting"
        className="font-mono"
      />
      <p className="text-[10px] text-muted-foreground">
        Use tags like `production` to keep the safety banner and card badges consistent.
      </p>
    </div>
  )
}

