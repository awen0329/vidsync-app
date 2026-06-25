import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

// cn merges Tailwind class names while resolving conflicts. Standard
// shadcn/ui idiom; useful even without shadcn since we will likely
// adopt it once the design stabilizes.
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
