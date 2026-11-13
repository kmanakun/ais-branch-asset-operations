import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/utils'

const badgeVariants = cva(
  'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11.5px] font-semibold whitespace-nowrap transition-colors',
  {
    variants: {
      variant: {
        default: 'border-emerald-200 bg-emerald-100 text-emerald-800',
        done: 'border-emerald-200 bg-emerald-100 text-emerald-800',
        green: 'border-emerald-200 bg-emerald-100 text-emerald-800',
        progress: 'border-sky-200 bg-sky-100 text-sky-800',
        ready: 'border-sky-200 bg-sky-100 text-sky-800',
        blue: 'border-sky-200 bg-sky-100 text-sky-800',
        blocked: 'border-amber-200 bg-amber-100 text-amber-800',
        orange: 'border-amber-200 bg-amber-100 text-amber-800',
        warning: 'border-amber-200 bg-amber-100 text-amber-800',
        destructive: 'border-red-200 bg-red-100 text-red-800',
        red: 'border-red-200 bg-red-100 text-red-800',
        neutral: 'border-slate-200 bg-slate-100 text-slate-700',
        secondary: 'border-slate-200 bg-slate-100 text-slate-700',
        outline: 'border-slate-300 bg-white text-slate-700',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  },
)

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />
}

export { Badge, badgeVariants }
