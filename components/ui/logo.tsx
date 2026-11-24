"use client";

import Link from "next/link";
import Image from "next/image";
import { usePathname } from "next/navigation";
import logo from "@/public/images/logo.svg";

export default function Logo() {
  // On /play the site header sits inert under the fullscreen game: prefetching "/" from there would
  // preload the home page's stylesheet, which /play never uses (a console warning). Every other page
  // keeps Next's default prefetch.
  const pathname = usePathname();
  return (
    <Link href="/" prefetch={pathname === "/play" ? false : undefined} className="inline-flex shrink-0" aria-label="Cruip">
      <Image src={logo} alt="Cruip Logo" width={32} height={32} />
    </Link>
  );
}
