// The privacy policy's link on the screens before sign-in (Sign in, Create account).
import { Link } from '@tanstack/react-router';

export function PolicyLink({ from }: { from: string }) {
  return (
    <Link
      to="/privacy-policy"
      search={{ back: from }}
      data-track="signin.policy"
      className="self-start text-sm text-accent"
    >
      Privacy policy
    </Link>
  );
}
