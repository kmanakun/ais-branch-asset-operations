import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/utils'

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-lg text-[13px] font-semibold transition-all disabled:pointer-events-none disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 [&_svg]:pointer-events-none [&_svg]:shrink-0 cursor-pointer',
  {
    variants: {
      variant: {
        default: 'bg-emerald-600 text-white shadow-xs hover:bg-emerald-700 focus-visible:ring-emerald-600',
        destructive: 'bg-red-600 text-white shadow-xs hover:bg-red-700 focus-visible:ring-red-600',
        outline: 'border border-slate-300 bg-white text-slate-700 shadow-2xs hover:bg-slate-50 hover:text-slate-900 focus-visible:ring-emerald-600',
        secondary: 'bg-emerald-50 text-emerald-800 border border-emerald-200 hover:bg-emerald-100 focus-visible:ring-emerald-600',
        ghost: 'text-slate-600 hover:bg-slate-100 hover:text-slate-900 focus-visible:ring-emerald-600',
        link: 'text-emerald-700 underline-offset-4 hover:underline focus-visible:ring-emerald-600',
      },
      size: {
        default: 'h-9.5 px-3.5 py-2 text-[13px]',
        sm: 'h-8 rounded-md px-3 text-xs',
        lg: 'h-11 rounded-lg px-5 text-sm',
        icon: 'size-9',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
)

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, type = 'button', ...props }, ref) => {
    return (
      <button
        ref={ref}
        type={type}
        className={cn(buttonVariants({ variant, size, className }))}
        {...props}
      />
    )
  },
)
Button.displayName = 'Button'

export { Button, buttonVariants }
