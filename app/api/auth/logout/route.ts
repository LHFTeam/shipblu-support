import { NextResponse } from 'next/server';
import { destroySession } from '@/lib/auth/session';

/**
 * POST rather than a link: a GET logout can be triggered by any image tag on
 * any page, which is a nuisance rather than a vulnerability but an avoidable
 * one.
 */
export async function POST(request: Request) {
  await destroySession();
  return NextResponse.redirect(new URL('/login', request.url), { status: 303 });
}
