# D-97: Activity opens on Not posted yet (Nov 12, 2026)

**Decided by the owner** (chat, Nov 12, 2026): "for activity can we have the default view be not posted yet?"
Changes `docs/design.md` (Activity row of the screens table), where All was the filter Activity opened on.

**Decision.**

1. **Activity with no filter chosen shows Not posted yet** on this month: the Activity tab, and any link to
   `/activity` without `?filter=`.
2. **It shows All instead** when nothing is waiting to post (`notPostedCount` is 0), on a past month (Not posted yet
   belongs to this month, `docs/month-header.md`), for a search (every month) and for one category's list from
   Reports.
3. **A chip you tap stays in the address**, All included (`?filter=all`), so Back and a reload keep it.
4. The Activity badge still counts Needs attention; its rows are one chip away.

Code: `apps/web/src/screens/Activity.tsx` (`chosenFilter`) and the `/activity` search in `apps/web/src/router.tsx`.
