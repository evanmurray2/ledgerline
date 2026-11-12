// Coming back into the app from Plaid's site (lib/plaid.ts): Bank connections and the repair sheet both finish here.
import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '../api/endpoints';
import { errorMessage } from '../api/client';
import { toast } from '../components/Toast';
import { resumeHostedLink } from './plaid';

/**
 * Hosted Link that left this page for Plaid's site, or outlived the app: on the way back in, ask the server what it
 * came to and say so.
 */
export function useResumeLink() {
  const qc = useQueryClient();
  useEffect(() => {
    let gone = false;
    void (async () => {
      try {
        const r = await resumeHostedLink();
        if (!r || gone || r.status === 'exited') return;
        if (r.status === 'repaired' && r.connectionId) await api.refreshConnection(r.connectionId);
        toast.show({
          text:
            r.status === 'linked'
              ? 'Linked. Transactions show up in Activity in a few minutes.'
              : 'Signed in again. Its transactions are on the way.',
        });
      } catch (e) {
        if (!gone) toast.show({ text: errorMessage(e) });
      } finally {
        if (!gone) void qc.invalidateQueries();
      }
    })();
    return () => {
      gone = true;
    };
  }, [qc]);
}
