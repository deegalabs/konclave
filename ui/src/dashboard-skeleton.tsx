import { Skeleton, SkeletonDetail, SkeletonRows, SkeletonStat, SkeletonStatus } from './skeleton'

/** The Dashboard before its first read lands, in the shape of what comes (#320): the vault's name
 *  over its subtitle, the desk and the movements in the main column, the balance at the side. Until
 *  now the whole page was one spinner, and the layout jumped when the real page replaced it.
 *  The word "Loading" is heard once, from this one status region; every block is hidden from
 *  assistive tech. */
export function DashboardSkeleton() {
  return (
    <main className="page dash">
      <SkeletonStatus />
      <header className="page-header" aria-hidden="true">
        <div className="page-header-main">
          <Skeleton width={120} height={11} />
          <Skeleton width="45%" height={30} style={{ marginTop: 10 }} />
          <Skeleton width="30%" height={13} style={{ marginTop: 10 }} />
        </div>
      </header>
      <div className="dash-cols">
        <div className="dash-main">
          <section className="needyou calm">
            <SkeletonDetail rows={2} status={false} />
          </section>
          <section className="ledger">
            <SkeletonRows n={4} status={false} />
          </section>
        </div>
        <aside className="dash-aside">
          <section className="entry">
            <SkeletonStat status={false} />
          </section>
        </aside>
      </div>
    </main>
  )
}
