import React, { useEffect, useRef, useState } from "react";

export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState<boolean>(() => {
    if (typeof window === "undefined" || !window.matchMedia) return false;
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  });

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const handler = (e: MediaQueryListEvent) => setReduced(e.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);

  return reduced;
}

interface RollingTextProps {
  value: string | number;
  className?: string;
  delayMs?: number;
  startFromZero?: boolean;
}

/**
 * Smooth 60fps rolling number component that renders as a single native text node
 * with `tabular-nums`, preserving exact baseline alignment and ellipsis truncation.
 */
export const RollingNumber: React.FC<RollingTextProps> = ({
  value,
  className = "",
  delayMs = 0,
  startFromZero = true,
}) => {
  const reducedMotion = usePrefersReducedMotion();
  const strValue = String(value);

  // Extract first numeric token (e.g. "$3,482.17" -> prefix "$", num 3482.17, suffix "")
  const parsed = React.useMemo(() => {
    const match = /^([^0-9-]*)(-?\d[\d,]*\.?\d*)(.*)$/.exec(strValue);
    if (!match) {
      return null;
    }
    const prefix = match[1];
    const numRaw = match[2].replace(/,/g, "");
    const suffix = match[3];
    const num = parseFloat(numRaw);
    if (Number.isNaN(num)) return null;
    const dotIdx = numRaw.indexOf(".");
    const decimals = dotIdx === -1 ? 0 : numRaw.length - dotIdx - 1;
    const useCommas = match[2].includes(",");
    return { prefix, num, suffix, decimals, useCommas };
  }, [strValue]);

  const [displayNum, setDisplayNum] = useState<number>(() => {
    if (reducedMotion || !parsed) return parsed ? parsed.num : 0;
    return startFromZero ? 0 : parsed.num;
  });

  const currentValRef = useRef<number>(
    reducedMotion || !parsed ? (parsed ? parsed.num : 0) : startFromZero ? 0 : parsed.num
  );

  useEffect(() => {
    if (!parsed) return;
    if (reducedMotion) {
      currentValRef.current = parsed.num;
      setDisplayNum(parsed.num);
      return;
    }

    const fromVal = currentValRef.current;
    const toVal = parsed.num;
    if (Math.abs(toVal - fromVal) < 0.0001) {
      setDisplayNum(toVal);
      return;
    }

    let rafId = 0;
    let timeoutId = 0;
    const duration = 420;

    const startAnim = () => {
      const startTime = performance.now();
      const step = (now: number) => {
        const elapsed = now - startTime;
        const t = Math.min(1, Math.max(0, elapsed / duration));
        // quartOut easing: 1 - (1 - t)^4
        const eased = 1 - Math.pow(1 - t, 4);
        const nextVal = fromVal + (toVal - fromVal) * eased;
        currentValRef.current = nextVal;
        setDisplayNum(nextVal);
        if (t < 1) {
          rafId = window.requestAnimationFrame(step);
        } else {
          currentValRef.current = toVal;
          setDisplayNum(toVal);
        }
      };
      rafId = window.requestAnimationFrame(step);
    };

    if (delayMs > 0) {
      timeoutId = window.setTimeout(startAnim, delayMs);
    } else {
      startAnim();
    }

    return () => {
      if (timeoutId) window.clearTimeout(timeoutId);
      if (rafId) window.cancelAnimationFrame(rafId);
    };
  }, [parsed, delayMs, reducedMotion]);

  if (!parsed || reducedMotion) {
    return <span className={`tabular-nums ${className}`}>{strValue}</span>;
  }

  const formattedNum = parsed.useCommas
    ? displayNum.toLocaleString("en-US", {
        minimumFractionDigits: parsed.decimals,
        maximumFractionDigits: parsed.decimals,
      })
    : displayNum.toFixed(parsed.decimals);

  return (
    <span className={`tabular-nums ${className}`}>
      {parsed.prefix}
      {formattedNum}
      {parsed.suffix}
    </span>
  );
};

interface RisingWordProps {
  text: string;
  visible: boolean;
  baseDelayMs?: number;
  letterStaggerMs?: number;
  durationMs?: number;
  easing?: string;
  className?: string;
  letterByLetter?: boolean;
}

/**
 * Masked title rise that supports native CSS ellipsis truncation (`truncate`).
 * When `letterByLetter` is true (e.g. "Shoebox" wordmark), animates each letter with a 22ms stagger.
 * For dynamic merchant names in tiles, animates the masked line rise so native `text-overflow: ellipsis` works cleanly.
 */
export const RisingWord: React.FC<RisingWordProps> = ({
  text,
  visible,
  baseDelayMs = 0,
  letterStaggerMs = 22,
  durationMs = 500,
  easing = "var(--ease-spring)",
  className = "",
  letterByLetter = false,
}) => {
  const reducedMotion = usePrefersReducedMotion();

  if (reducedMotion) {
    return (
      <span
        className={`block truncate transition-opacity duration-150 ${
          visible ? "opacity-100" : "opacity-0"
        } ${className}`}
        title={text}
      >
        {text}
      </span>
    );
  }

  if (!letterByLetter) {
    return (
      <span
        className={`block overflow-hidden ${className}`}
        style={{ paddingBottom: "0.1em", marginBottom: "-0.1em" }}
        title={text}
      >
        <span
          className="block truncate will-change-transform"
          style={{
            transform: visible ? "translateY(0%)" : "translateY(110%)",
            transitionProperty: "transform",
            transitionDuration: `${durationMs}ms`,
            transitionTimingFunction: easing,
            transitionDelay: visible ? `${baseDelayMs}ms` : "0ms",
          }}
        >
          {text}
        </span>
      </span>
    );
  }

  return (
    <span
      className={`block overflow-hidden whitespace-nowrap text-ellipsis ${className}`}
      style={{ paddingBottom: "0.08em", marginBottom: "-0.08em" }}
      title={text}
    >
      {text.split("").map((char, i) => (
        <span
          key={`${i}-${char}`}
          className="inline-block transition-transform will-change-transform"
          style={{
            transform: visible ? "translateY(0%)" : "translateY(112%)",
            transitionDuration: `${durationMs}ms`,
            transitionTimingFunction: easing,
            transitionDelay: visible
              ? `${baseDelayMs + i * letterStaggerMs}ms`
              : "0ms",
          }}
        >
          {char === " " ? "\u00A0" : char}
        </span>
      ))}
    </span>
  );
};

interface CustomScrollListProps {
  children: React.ReactNode;
  theme: "on-white" | "on-blue";
  fadeLastVisibleRow?: boolean;
  scrollToBottomTrigger?: number;
  className?: string;
}

/**
 * Custom scrollable container with the exact 1px track + 2px thumb scrollbar
 * from ad1_landing.png and ad1_results.png, plus optional bottom row fade to 30%.
 */
export const CustomScrollList: React.FC<CustomScrollListProps> = ({
  children,
  theme,
  fadeLastVisibleRow = false,
  scrollToBottomTrigger,
  className = "",
}) => {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [scrollState, setScrollState] = useState({
    hasOverflow: false,
    thumbTopPercent: 0,
    thumbHeightPercent: 30,
    atBottom: true,
  });

  const updateScrollMetrics = () => {
    const el = scrollRef.current;
    if (!el) return;
    const { scrollTop, scrollHeight, clientHeight } = el;
    const hasOverflow = scrollHeight > clientHeight + 2;
    if (!hasOverflow) {
      setScrollState({
        hasOverflow: false,
        thumbTopPercent: 0,
        thumbHeightPercent: 100,
        atBottom: true,
      });
      return;
    }

    const ratio = clientHeight / scrollHeight;
    const thumbHeightPercent = Math.max(15, Math.min(90, ratio * 100));
    const maxScroll = Math.max(1, scrollHeight - clientHeight);
    const scrollProgress = Math.min(1, Math.max(0, scrollTop / maxScroll));
    const thumbTopPercent = scrollProgress * (100 - thumbHeightPercent);
    const atBottom = scrollTop + clientHeight >= scrollHeight - 6;

    setScrollState({
      hasOverflow: true,
      thumbTopPercent,
      thumbHeightPercent,
      atBottom,
    });
  };

  useEffect(() => {
    updateScrollMetrics();
    window.addEventListener("resize", updateScrollMetrics);
    return () => window.removeEventListener("resize", updateScrollMetrics);
  }, [children]);

  useEffect(() => {
    if (scrollToBottomTrigger && scrollRef.current) {
      scrollRef.current.scrollTo({
        top: scrollRef.current.scrollHeight,
        behavior: "smooth",
      });
      window.setTimeout(updateScrollMetrics, 250);
    }
  }, [scrollToBottomTrigger]);

  const trackColor =
    theme === "on-white"
      ? "rgba(0, 110, 255, 0.28)"
      : "rgba(255, 255, 255, 0.35)";
  const thumbColor =
    theme === "on-white" ? "var(--blue-900)" : "var(--white)";

  return (
    <div className={`relative flex-1 min-h-0 flex ${className}`}>
      <div
        ref={scrollRef}
        onScroll={updateScrollMetrics}
        className="flex-1 min-h-0 overflow-y-auto no-native-scrollbar pr-4"
        style={
          fadeLastVisibleRow && scrollState.hasOverflow && !scrollState.atBottom
            ? {
                maskImage:
                  "linear-gradient(to bottom, rgba(0,0,0,1) 0%, rgba(0,0,0,1) calc(100% - 44px), rgba(0,0,0,0.3) 100%)",
                WebkitMaskImage:
                  "linear-gradient(to bottom, rgba(0,0,0,1) 0%, rgba(0,0,0,1) calc(100% - 44px), rgba(0,0,0,0.3) 100%)",
              }
            : undefined
        }
      >
        {children}
      </div>

      {/* Custom thin scrollbar matching ad1_landing.png and ad1_results.png */}
      <div className="relative w-[4px] shrink-0 my-1">
        <div
          className="absolute right-[1px] top-0 bottom-0 w-[1px]"
          style={{ backgroundColor: trackColor }}
        />
        {scrollState.hasOverflow && (
          <div
            className="absolute right-0 w-[2px] transition-all duration-75"
            style={{
              top: `${scrollState.thumbTopPercent}%`,
              height: `${scrollState.thumbHeightPercent}%`,
              backgroundColor: thumbColor,
            }}
          />
        )}
      </div>
    </div>
  );
};
