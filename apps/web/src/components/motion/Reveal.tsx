'use client';

import { motion, useReducedMotion } from 'framer-motion';
import type { ReactNode } from 'react';

const ease = [0.22, 1, 0.36, 1] as const;

export function FadeIn({
    children,
    delay = 0,
    className,
}: {
    children: ReactNode;
    delay?: number;
    className?: string;
}) {
    const reduce = useReducedMotion();
    if (reduce) {
        return <div className={className}>{children}</div>;
    }
    return (
        <motion.div
            className={className}
            initial={{ opacity: 0, y: 14 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.45, delay, ease }}
        >
            {children}
        </motion.div>
    );
}

export function ScrollReveal({
    children,
    className,
    delay = 0,
}: {
    children: ReactNode;
    className?: string;
    delay?: number;
}) {
    const reduce = useReducedMotion();
    if (reduce) {
        return <div className={className}>{children}</div>;
    }
    return (
        <motion.div
            className={className}
            initial={{ opacity: 0, y: 24 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: '-60px' }}
            transition={{ duration: 0.55, delay, ease }}
        >
            {children}
        </motion.div>
    );
}

export function Stagger({
    children,
    className,
    stagger = 0.08,
}: {
    children: ReactNode;
    className?: string;
    stagger?: number;
}) {
    const reduce = useReducedMotion();
    if (reduce) {
        return <div className={className}>{children}</div>;
    }
    return (
        <motion.div
            className={className}
            initial="hidden"
            whileInView="show"
            viewport={{ once: true, margin: '-40px' }}
            variants={{
                hidden: {},
                show: { transition: { staggerChildren: stagger } },
            }}
        >
            {children}
        </motion.div>
    );
}

export function StaggerItem({
    children,
    className,
}: {
    children: ReactNode;
    className?: string;
}) {
    const reduce = useReducedMotion();
    if (reduce) {
        return <div className={className}>{children}</div>;
    }
    return (
        <motion.div
            className={className}
            variants={{
                hidden: { opacity: 0, y: 16 },
                show: {
                    opacity: 1,
                    y: 0,
                    transition: { duration: 0.45, ease },
                },
            }}
        >
            {children}
        </motion.div>
    );
}
