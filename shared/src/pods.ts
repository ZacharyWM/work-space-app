// pod claims (notes/009): the claimable personal zones and who owns them
import { z } from "zod";

// one pod claim as it rides the welcome/podClaimed messages: the pod zone, the
// owning clerk user, and their display name (shown on the pod even offline)
export const podClaimSchema = z.object({
  zoneId: z.string().min(1),
  userId: z.string().min(1),
  name: z.string().min(1),
});
export type PodClaim = z.infer<typeof podClaimSchema>;
