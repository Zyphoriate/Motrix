import { NotificationsIcon } from '@renderer/components/icons'
import {
  SidebarMenuButton,
  SidebarMenuItem,
} from '@renderer/components/ui/sidebar'
import { cn } from '@renderer/lib/utils'
import { useTranslation } from 'react-i18next'
import { NavLink } from 'react-router'
import { useNotifications } from './use-notifications'
import { usePendingMediaSelections } from './use-pending-media-selections'

const UNREAD_DISPLAY_CAP = 99

/**
 * Notification history uses a count-only mirror. The independent pending queue
 * takes badge priority until its action is resolved, even after history clears.
 */
export function NotificationsNavItem() {
  const { t } = useTranslation()
  const { unreadCount, badgeStyle } = useNotifications({ countOnly: true })
  const { items: pendingSelections } = usePendingMediaSelections()
  const hasPending = pendingSelections.length > 0
  const displayCount = hasPending ? pendingSelections.length : unreadCount
  const effectiveStyle = hasPending ? 'count' : badgeStyle
  const badgeAria = hasPending
    ? t('mediaSelection.pending.badgeAria', { total: pendingSelections.length })
    : t('notification.center.unreadBadgeAria', { count: unreadCount })
  const badgeLabel =
    displayCount > UNREAD_DISPLAY_CAP
      ? `${UNREAD_DISPLAY_CAP}+`
      : String(displayCount)

  return (
    <SidebarMenuItem>
      <NavLink to="/notifications">
        {({ isActive }) => (
          <SidebarMenuButton
            render={<span />}
            isActive={isActive}
            tooltip={t('nav.notifications')}
            className="relative cursor-default"
          >
            <NotificationsIcon />
            <span className="select-none">{t('nav.notifications')}</span>
            {displayCount > 0 && effectiveStyle === 'dot' && (
              <span
                data-testid="notification-badge-dot"
                role="status"
                aria-label={t('notification.center.unreadDotAria')}
                className="ms-auto size-1.5 shrink-0 rounded-full bg-[#007aff] group-data-[collapsible=icon]:absolute group-data-[collapsible=icon]:top-1 group-data-[collapsible=icon]:end-1"
              />
            )}
            {displayCount > 0 && effectiveStyle === 'count' && (
              <>
                <span
                  data-testid="notification-badge"
                  role="status"
                  aria-label={badgeAria}
                  className={cn(
                    'ms-auto flex h-[18px] min-w-[18px] shrink-0 items-center justify-center rounded-full px-1 text-[11px] font-semibold leading-none proportional-nums group-data-[collapsible=icon]:hidden',
                    hasPending
                      ? 'bg-amber-400 text-amber-950'
                      : 'bg-[#007aff] text-white'
                  )}
                >
                  {badgeLabel}
                </span>
                <span
                  data-testid="notification-badge-dot"
                  aria-hidden="true"
                  className={cn(
                    'absolute top-1 end-1 hidden size-1.5 rounded-full group-data-[collapsible=icon]:block',
                    hasPending ? 'bg-amber-400' : 'bg-[#007aff]'
                  )}
                />
              </>
            )}
          </SidebarMenuButton>
        )}
      </NavLink>
    </SidebarMenuItem>
  )
}
