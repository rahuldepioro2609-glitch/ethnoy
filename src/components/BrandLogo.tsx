import React from 'react';

interface BrandLogoProps {
  compact?: boolean;
  light?: boolean;
}

export const BrandLogo: React.FC<BrandLogoProps> = ({ compact = false, light = false }) => (
  <span className="inline-flex items-center gap-2.5">
    <img
      src="/assets/eltnoy-logo.png"
      alt=""
      aria-hidden="true"
      className={`${compact ? 'h-10 w-14' : 'h-11 w-16'} shrink-0 rounded-md bg-white object-contain`}
    />
    <span className="flex flex-col leading-none">
      <span className={`text-[23px] font-black tracking-[-0.055em] sm:text-[25px] ${light ? 'text-white' : 'text-[#0B2E59]'}`}>
        <span className="text-emerald-600">ELT</span>NOY
      </span>
      <span className={`mt-1.5 text-[8px] font-bold uppercase tracking-[0.16em] sm:text-[9px] ${light ? 'text-slate-300' : 'text-slate-500'}`}>
        Examination Portal
      </span>
    </span>
  </span>
);
