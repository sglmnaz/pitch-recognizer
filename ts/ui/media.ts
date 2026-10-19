// Media queries more than one module reads; .matches is always current.

/** The phone layout (tab bar docked at the bottom): the stylesheet's breakpoint. */
export const phone = matchMedia('(max-width: 600px)')

/** No flashes or decorative motion. */
export const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)')
