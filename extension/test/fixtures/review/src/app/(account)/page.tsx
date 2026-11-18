import { useCartStore } from '../../lib/store'

export default function AccountPage() {
  const count = useCartStore()
  return <div>{count}</div>
}
