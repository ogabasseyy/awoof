'use client';

import React from 'react';
import Link from 'next/link';
import { motion, useReducedMotion } from 'framer-motion';
import { ArrowRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import Applestore from './applestore';
import Googleplaystore from './googleplaystore';

export default function Banner() {
  const reduce = useReducedMotion();

  return (
    <div className="relative z-30 flex flex-col items-start justify-center min-h-[calc(100vh-5rem)] lg:min-h-[calc(100vh-6rem)] py-16 lg:py-20 pr-0 lg:pr-[38%] xl:pr-[42%]">
      <motion.p
        className="text-sm font-semibold text-blue-100/90 mb-4"
        initial={reduce ? false : { opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
      >
        Verified student marketplace
      </motion.p>

      <motion.h1
        className="text-white font-extrabold text-[clamp(2.25rem,5vw,4.25rem)] leading-[1.05] tracking-tight max-w-xl text-balance"
        style={{ textWrap: 'balance' as never }}
        initial={reduce ? false : { opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.55, delay: 0.08, ease: [0.22, 1, 0.36, 1] }}
      >
        Your student ID just got more powerful
      </motion.h1>

      <motion.p
        className="mt-5 text-base sm:text-lg text-blue-50/95 leading-relaxed max-w-md"
        initial={reduce ? false : { opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, delay: 0.18, ease: [0.22, 1, 0.36, 1] }}
      >
        Unlock exclusive discounts on food, tech, and travel — only for verified students.
      </motion.p>

      <motion.div
        className="mt-8 flex flex-col sm:flex-row items-stretch sm:items-center gap-3 w-full max-w-md"
        initial={reduce ? false : { opacity: 0, y: 14 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, delay: 0.28, ease: [0.22, 1, 0.36, 1] }}
      >
        <Link href="/marketplace" className="flex-1 sm:flex-none">
          <Button
            size="lg"
            className="w-full sm:w-auto rounded-full bg-white text-[#1D4ED8] hover:bg-blue-50 font-bold px-7 h-12 shadow-lg shadow-blue-900/20 transition-transform hover:-translate-y-0.5"
          >
            Browse deals
            <ArrowRight className="h-4 w-4" />
          </Button>
        </Link>
        <Link href="/auth/student/register" className="flex-1 sm:flex-none">
          <Button
            size="lg"
            variant="outline"
            className="w-full sm:w-auto rounded-full border-2 border-white/80 bg-transparent text-white hover:bg-white/15 font-bold px-7 h-12 transition-transform hover:-translate-y-0.5"
          >
            Sign up free
          </Button>
        </Link>
      </motion.div>

      <motion.div
        className="mt-10 flex flex-col gap-3"
        initial={reduce ? false : { opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.5, delay: 0.45 }}
      >
        <p className="text-xs font-medium uppercase tracking-wide text-blue-100/70">
          Also on mobile
        </p>
        <div className="flex flex-wrap items-center gap-3 opacity-90 scale-90 origin-left">
          <Googleplaystore />
          <Applestore />
        </div>
      </motion.div>
    </div>
  );
}
