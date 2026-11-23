// What every page shows until its own task gives it content: where it is, its name, and the
// shape its content will take, as stock Skeletons. One GSAP timeline brings them in.
import * as React from "react"
import { useGSAP } from "@gsap/react"
import gsap from "gsap"
import { Link } from "react-router"

import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb"
import { Skeleton } from "@/components/ui/skeleton"

gsap.registerPlugin(useGSAP)

export type Crumb = { label: string; to: string }

export function Placeholder({ title, crumbs = [], children }: { title: string; crumbs?: Crumb[]; children?: React.ReactNode }) {
  const scope = React.useRef<HTMLDivElement>(null)

  useGSAP(
    () => {
      // Opacity, not autoAlpha: autoAlpha sets visibility: hidden, and a hidden element cannot take
      // focus, so j pressed while the heading is still fading in would skip it (flyingrobots/school#114).
      gsap.matchMedia().add("(prefers-reduced-motion: no-preference)", () => {
        gsap
          .timeline({ defaults: { ease: "power2.out" } })
          .from("[data-animate=heading]", { y: 24, opacity: 0, duration: 0.4 })
          .from("[data-slot=skeleton]", { y: 16, opacity: 0, duration: 0.3, stagger: 0.04 }, "-=0.2")
      })
    },
    { scope, dependencies: [title], revertOnUpdate: true }
  )

  return (
    <div ref={scope} className="flex w-full flex-col gap-8">
      <div data-animate="heading" className="flex flex-col gap-3">
        <Breadcrumb>
          <BreadcrumbList className="text-base">
            {crumbs.map((c) => (
              <React.Fragment key={c.to}>
                <BreadcrumbItem>
                  <BreadcrumbLink asChild>
                    <Link to={c.to} data-nav>
                      {c.label}
                    </Link>
                  </BreadcrumbLink>
                </BreadcrumbItem>
                <BreadcrumbSeparator />
              </React.Fragment>
            ))}
            <BreadcrumbItem>
              <BreadcrumbPage>{title}</BreadcrumbPage>
            </BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>
        <h1 className="font-heading text-4xl font-semibold tracking-tight sm:text-5xl 2xl:text-6xl">{title}</h1>
        {children}
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
        {Array.from({ length: 8 }, (_, i) => (
          <Skeleton key={i} className="h-40 w-full" />
        ))}
      </div>
    </div>
  )
}
