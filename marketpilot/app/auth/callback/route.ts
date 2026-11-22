import { NextResponse, type NextRequest } from 'next/server';
import { createSupabaseServerClient } from '@/lib/supabase/server';

export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const nextPath = url.searchParams.get('next') ?? '/';
  const safePath = nextPath.startsWith('/') && !nextPath.startsWith('//') ? nextPath : '/';

  if (!code) {
    return NextResponse.redirect(new URL('/?authError=link', request.url));
  }

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.auth.exchangeCodeForSession(code);
  if (error) {
    return NextResponse.redirect(new URL('/?authError=link', request.url));
  }

  return NextResponse.redirect(new URL(safePath, request.url));
}
