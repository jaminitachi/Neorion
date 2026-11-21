import { memo, useState as useReactState } from 'react'
import { useCartStore as useCart } from '@/lib/store'
import { Button } from './ui/button'

function Inner({ children, ...props }) {
  useReactState()
  const count = useCart()
  return <Button {...props}>{children}{count}</Button>
}

export default memo(Inner)
