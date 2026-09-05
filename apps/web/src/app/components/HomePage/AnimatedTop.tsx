'use client';

import Image from 'next/image';
import PhoneImage from '../../../../public/images/iPhone 13 Pro.svg';
import GraduationCap from '../../../../public/images/noto_graduation-large-cap.svg';
import BestDeals from '../../../../public/images/BestDealsIcon.svg';
import New from '../../../../public/images/NewIcon.svg';
import { motion, useReducedMotion } from 'framer-motion';

function AnimatedTop() {
  const reduce = useReducedMotion();

  return (
    <div className="absolute bottom-0 right-0 pointer-events-none hidden lg:block">
      <div className="absolute right-[12vw] xl:right-[250px] bottom-[45vh] xl:bottom-[480px] z-10">
        <motion.div
          initial={reduce ? false : { y: -40, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          transition={{ duration: 0.7, ease: [0.22, 1, 0.36, 1], delay: 0.35 }}
        >
          <Image src={GraduationCap} alt="" className="w-12 xl:w-auto h-auto" />
        </motion.div>
      </div>

      <motion.div
        className="absolute right-[22vw] xl:right-[420px] bottom-[14vh] xl:bottom-[150px] z-10"
        initial={reduce ? false : { opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.6, delay: 0.55, ease: [0.22, 1, 0.36, 1] }}
      >
        <Image src={BestDeals} alt="" className="w-16 xl:w-auto h-auto" />
      </motion.div>
      <motion.div
        className="absolute right-[2vw] xl:right-[40px] bottom-[56vh] xl:bottom-[600px] z-10"
        initial={reduce ? false : { opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.6, delay: 0.7, ease: [0.22, 1, 0.36, 1] }}
      >
        <Image src={New} alt="" className="w-12 xl:w-auto h-auto" />
      </motion.div>
      <div className="relative bottom-0 right-0 z-[5]">
        <motion.div
          initial={reduce ? false : { x: 80, opacity: 0 }}
          animate={{ x: 0, opacity: 1 }}
          transition={{ duration: 0.75, ease: [0.22, 1, 0.36, 1], delay: 0.2 }}
        >
          <Image
            src={PhoneImage}
            alt="Awoof on mobile"
            className="w-40 xl:w-auto h-auto max-h-[70vh]"
          />
        </motion.div>
      </div>
    </div>
  );
}

export default AnimatedTop;
