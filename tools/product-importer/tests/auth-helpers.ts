export const adminEnv={IMPORTER_USERNAME:'test-admin',IMPORTER_PASSWORD:'test-admin-password-unique'};
export async function loginForTest(origin:string) {
  const response=await fetch(origin+'/login',{method:'POST',redirect:'manual',headers:{Origin:origin,'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({username:adminEnv.IMPORTER_USERNAME,password:adminEnv.IMPORTER_PASSWORD})});
  if(response.status!==303)throw Error('Test login failed');
  return response.headers.get('set-cookie')!.split(';')[0];
}
