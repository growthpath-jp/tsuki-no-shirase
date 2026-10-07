-- 設定を「変更した項目だけ」まとめて書き込む（同時保存で片方が消えないように）
create or replace function public.merge_settings(p_pair uuid, p_patch jsonb)
returns jsonb language sql security definer set search_path = public as $$
  update public.pairs set settings = coalesce(settings, '{}'::jsonb) || p_patch where id = p_pair returning settings;
$$;
revoke all on function public.merge_settings(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.merge_settings(uuid, jsonb) to service_role;
